const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL is missing. Add a Render PostgreSQL database and set DATABASE_URL.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "2mb" }));

const STATIC_FILES = new Set([
  "index.html",
  "pricing.html",
  "login.html",
  "register.html",
  "dashboard.html"
]);

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/:file", (req, res, next) => {
  if (!STATIC_FILES.has(req.params.file)) return next();
  res.sendFile(path.join(__dirname, req.params.file));
});

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return hash === expectedHash;
}

function signSession(userId) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 7
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function readCookies(header = "") {
  return header.split(";").reduce((cookies, cookie) => {
    const [key, ...value] = cookie.trim().split("=");
    if (key) cookies[key] = decodeURIComponent(value.join("="));
    return cookies;
  }, {});
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;

  const [payload, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");

  if (signature !== expected) return null;

  const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!session.expiresAt || session.expiresAt < Date.now()) return null;

  return session;
}

function setSessionCookie(res, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `oe_session=${signSession(userId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "oe_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

async function currentUser(req) {
  const cookies = readCookies(req.headers.cookie);
  const session = verifySessionToken(cookies.oe_session);

  if (!session) return null;

  const result = await pool.query(
    "select id, name, email, role, created_at from users where id = $1",
    [session.userId]
  );

  return result.rows[0] || null;
}

async function requireUser(req, res, next) {
  try {
    const user = await currentUser(req);

    if (!user) {
      return res.status(401).json({ error: "Please login first." });
    }

    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

async function initDatabase() {
  await pool.query(`
    create table if not exists users (
      id text primary key,
      name text not null,
      email text unique not null,
      role text not null,
      password_hash text not null,
      password_salt text not null,
      created_at timestamptz not null default now()
    );

    create table if not exists groups (
      id text primary key,
      owner_id text not null references users(id) on delete cascade,
      name text not null,
      sport text not null,
      start_date text not null,
      end_date text not null,
      type text not null default 'static',
      created_at timestamptz not null default now()
    );

    create table if not exists umpires (
      id text primary key,
      group_id text not null references groups(id) on delete cascade,
      name text not null,
      contact text,
      availability text,
      conflicts text,
      abilities text,
      superiority integer not null default 3,
      created_at timestamptz not null default now()
    );

    create table if not exists games (
      id text primary key,
      group_id text not null references groups(id) on delete cascade,
      date text,
      time text,
      field text,
      team_one text not null,
      team_two text not null,
      level text,
      umpire_id text references umpires(id) on delete set null,
      source text not null default 'single',
      created_at timestamptz not null default now()
    );
  `);
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role
  };
}

async function getGroups(userId) {
  const groupsResult = await pool.query(
    "select * from groups where owner_id = $1 order by created_at desc",
    [userId]
  );

  const groups = groupsResult.rows.map(group => ({
    id: group.id,
    name: group.name,
    sport: group.sport,
    startDate: group.start_date,
    endDate: group.end_date,
    type: group.type,
    umpires: [],
    games: []
  }));

  for (const group of groups) {
    const umpires = await pool.query(
      "select * from umpires where group_id = $1 order by created_at asc",
      [group.id]
    );

    const games = await pool.query(
      "select * from games where group_id = $1 order by date asc, time asc",
      [group.id]
    );

    group.umpires = umpires.rows.map(umpire => ({
      id: umpire.id,
      name: umpire.name,
      contact: umpire.contact || "",
      availability: umpire.availability || "",
      conflicts: umpire.conflicts || "",
      abilities: umpire.abilities || "",
      superiority: String(umpire.superiority || 3)
    }));

    group.games = games.rows.map(game => ({
      id: game.id,
      date: game.date || "",
      time: game.time || "",
      field: game.field || "",
      teamOne: game.team_one,
      teamTwo: game.team_two,
      level: game.level || "",
      umpireId: game.umpire_id || "",
      source: game.source
    }));
  }

  return groups;
}

async function ownsGroup(groupId, userId) {
  const result = await pool.query(
    "select id from groups where id = $1 and owner_id = $2",
    [groupId, userId]
  );

  return Boolean(result.rows[0]);
}

app.post("/api/register", async (req, res, next) => {
  try {
    const firstName = String(req.body.firstName || "").trim();
    const lastName = String(req.body.lastName || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const role = String(req.body.role || "").trim();
    const password = String(req.body.password || "");

    if (!firstName || !lastName || !email || !role || password.length < 6) {
      return res.status(400).json({ error: "Please complete every required field." });
    }

    const existing = await pool.query("select id from users where email = $1", [email]);

    if (existing.rows[0]) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const id = crypto.randomUUID();
    const { salt, hash } = hashPassword(password);

    const result = await pool.query(
      `insert into users (id, name, email, role, password_hash, password_salt)
       values ($1, $2, $3, $4, $5, $6)
       returning id, name, email, role, created_at`,
      [id, `${firstName} ${lastName}`, email, role, hash, salt]
    );

    setSessionCookie(res, id);
    res.status(201).json({ user: publicUser(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query("select * from users where email = $1", [email]);
    const user = result.rows[0];

    if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    setSessionCookie(res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/groups", requireUser, async (req, res, next) => {
  try {
    res.json({ groups: await getGroups(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/groups", requireUser, async (req, res, next) => {
  try {
    const id = crypto.randomUUID();

    await pool.query(
      `insert into groups (id, owner_id, name, sport, start_date, end_date, type)
       values ($1, $2, $3, $4, $5, $6, 'static')`,
      [
        id,
        req.user.id,
        String(req.body.name || "").trim(),
        String(req.body.sport || "").trim(),
        String(req.body.startDate || "").trim(),
        String(req.body.endDate || "").trim()
      ]
    );

    res.status(201).json({
      groups: await getGroups(req.user.id),
      activeGroupId: id
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/groups/:groupId/umpires", requireUser, async (req, res, next) => {
  try {
    if (!(await ownsGroup(req.params.groupId, req.user.id))) {
      return res.status(404).json({ error: "Group not found." });
    }

    await pool.query(
      `insert into umpires (id, group_id, name, contact, availability, conflicts, abilities, superiority)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        req.params.groupId,
        String(req.body.name || "").trim(),
        String(req.body.contact || "").trim(),
        String(req.body.availability || "").trim(),
        String(req.body.conflicts || "").trim(),
        String(req.body.abilities || "").trim(),
        Number(req.body.superiority || 3)
      ]
    );

    res.status(201).json({ groups: await getGroups(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/groups/:groupId/games", requireUser, async (req, res, next) => {
  try {
    if (!(await ownsGroup(req.params.groupId, req.user.id))) {
      return res.status(404).json({ error: "Group not found." });
    }

    await pool.query(
      `insert into games (id, group_id, date, time, field, team_one, team_two, level, umpire_id, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, nullif($9, ''), 'single')`,
      [
        crypto.randomUUID(),
        req.params.groupId,
        String(req.body.date || "").trim(),
        String(req.body.time || "").trim(),
        String(req.body.field || "").trim(),
        String(req.body.teamOne || "").trim(),
        String(req.body.teamTwo || "").trim(),
        String(req.body.level || "").trim(),
        String(req.body.umpireId || "").trim()
      ]
    );

    res.status(201).json({ groups: await getGroups(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/groups/:groupId/games/bulk", requireUser, async (req, res, next) => {
  try {
    if (!(await ownsGroup(req.params.groupId, req.user.id))) {
      return res.status(404).json({ error: "Group not found." });
    }

    const games = Array.isArray(req.body.games) ? req.body.games : [];

    for (const game of games) {
      await pool.query(
        `insert into games (id, group_id, date, time, field, team_one, team_two, level, source)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'bulk')`,
        [
          crypto.randomUUID(),
          req.params.groupId,
          String(game.date || "").trim(),
          String(game.time || "").trim(),
          String(game.field || "").trim(),
          String(game.teamOne || "Team 1").trim(),
          String(game.teamTwo || "Team 2").trim(),
          String(game.level || "").trim()
        ]
      );
    }

    res.status(201).json({ groups: await getGroups(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/groups/:groupId/games/:gameId", requireUser, async (req, res, next) => {
  try {
    if (!(await ownsGroup(req.params.groupId, req.user.id))) {
      return res.status(404).json({ error: "Group not found." });
    }

    await pool.query(
      `update games
       set umpire_id = nullif($1, '')
       where id = $2 and group_id = $3`,
      [
        String(req.body.umpireId || "").trim(),
        req.params.gameId,
        req.params.groupId
      ]
    );

    res.json({ groups: await getGroups(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: error.message || "Something went wrong." });
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Officials Engine server running on port ${PORT}`);
  });
});

from pydantic import BaseModel

class Pitch(BaseModel):
    pitch_id: int
    location_zone: str
    ai_call: str
    umpire_call: str
    team_at_bat: str
    confidence: float

class UmpEngine:

    def grade_game(self, pitches):

        correct = 0
        total = 0

        home_misses = 0
        away_misses = 0

        zone_counts = {}

        for p in pitches:

            # accuracy
            if p.ai_call == p.umpire_call:
                correct += 1
            else:
                if p.team_at_bat == "home":
                    home_misses += 1
                else:
                    away_misses += 1

            total += 1

            # consistency tracking
            zone = p.location_zone
            if zone not in zone_counts:
                zone_counts[zone] = []
            zone_counts[zone].append(p.umpire_call)

        # accuracy
        accuracy = correct / total if total else 0

        # consistency (simple version)
        consistency_scores = []
        for zone, calls in zone_counts.items():
            strike_rate = calls.count("strike") / len(calls)
            consistency_scores.append(strike_rate)

        consistency = 1 - (sum(consistency_scores) / len(consistency_scores)) if consistency_scores else 0

        # bias
        bias = home_misses - away_misses

        return {
            "accuracy": round(accuracy * 100, 2),
            "consistency": round(consistency * 100, 2),
            "bias_home": home_misses,
            "bias_away": away_misses,
            "final_grade": round((accuracy * 0.5 + consistency * 0.3) * 100, 2)
        }

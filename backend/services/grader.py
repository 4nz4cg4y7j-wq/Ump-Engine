class Grader:

    def accuracy(self, pitches):
        correct = 0
        total = 0

        for p in pitches:
            if p.ai_call == p.umpire_call:
                correct += 1
            total += 1

        return correct / total if total else 0

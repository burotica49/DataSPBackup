/**
 * Décision pure : après une tentative, la base est-elle indisponible,
 * et faut-il notifier (une seule fois, au franchissement du seuil) ?
 */
export interface AvailDecisionInput {
  ok: boolean;
  failStreak: number;
  alreadyDown: boolean;
  attempts: number;
  notify: boolean;
}

export interface AvailDecision {
  failStreak: number;
  down: boolean;
  shouldNotify: boolean;
}

export function decideAvailability(input: AvailDecisionInput): AvailDecision {
  if (input.ok) {
    return { failStreak: 0, down: false, shouldNotify: false };
  }
  const failStreak = input.failStreak + 1;
  const crossed = failStreak >= Math.max(1, input.attempts);
  return {
    failStreak,
    down: input.alreadyDown || crossed,
    shouldNotify: input.notify && crossed && !input.alreadyDown,
  };
}

/** Retire un secret éventuel et borne la longueur stockée. */
export function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/(password|pwd|token|secret)\s*[=:]\s*\S+/gi, "$1=***")
    .slice(0, 400);
}

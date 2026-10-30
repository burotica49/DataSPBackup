import { describe, expect, it } from "vitest";
import { decideAvailability, safeError } from "./state.js";

const base = {
  failStreak: 0,
  alreadyDown: false,
  attempts: 3,
  notify: true,
};

describe("decideAvailability", () => {
  it("remet le compteur à zéro quand la base répond", () => {
    const d = decideAvailability({ ...base, ok: true, failStreak: 2, alreadyDown: true });
    expect(d).toEqual({ failStreak: 0, down: false, shouldNotify: false });
  });

  it("n'alerte pas tant que le seuil n'est pas atteint", () => {
    const d = decideAvailability({ ...base, ok: false, failStreak: 1 });
    expect(d).toEqual({ failStreak: 2, down: false, shouldNotify: false });
  });

  it("marque indisponible et notifie une seule fois au seuil", () => {
    const down = decideAvailability({ ...base, ok: false, failStreak: 2 });
    expect(down).toEqual({ failStreak: 3, down: true, shouldNotify: true });
    const again = decideAvailability({
      ...base,
      ok: false,
      failStreak: down.failStreak,
      alreadyDown: true,
    });
    expect(again.down).toBe(true);
    expect(again.shouldNotify).toBe(false);
  });

  it("n'envoie rien si la notification est désactivée", () => {
    const d = decideAvailability({ ...base, ok: false, failStreak: 2, notify: false });
    expect(d.down).toBe(true);
    expect(d.shouldNotify).toBe(false);
  });
});

describe("safeError", () => {
  it("masque un mot de passe présent dans le message", () => {
    expect(safeError(new Error("auth failed password=s3cret host=db"))).toBe(
      "auth failed password=*** host=db",
    );
  });
});

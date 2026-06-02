import { describe, expect, it } from "vitest";
import { createPromotionalBountySchema } from "../shared/schema";

const validBounty = {
  repoId: 1,
  type: "PROMOTIONAL",
  title: "Share the new launch",
  description: "Create a public promotional post for the new launch.",
  promotionalChannels: ["Twitter"],
  requiredDeliverable: "Public post URL",
  rewardAmount: "10",
  rewardType: "PER_SUBMISSION",
};

describe("promotional bounty reward currency", () => {
  it("defaults promotional bounty rewards to ROXN", () => {
    const parsed = createPromotionalBountySchema.parse(validBounty);

    expect(parsed.rewardCurrency).toBe("ROXN");
  });

  it("accepts supported reward currencies", () => {
    for (const rewardCurrency of ["XDC", "ROXN", "USDC"] as const) {
      const parsed = createPromotionalBountySchema.parse({
        ...validBounty,
        rewardCurrency,
      });

      expect(parsed.rewardCurrency).toBe(rewardCurrency);
    }
  });

  it("rejects unsupported reward currencies", () => {
    expect(() =>
      createPromotionalBountySchema.parse({
        ...validBounty,
        rewardCurrency: "ETH",
      })
    ).toThrow();
  });
});

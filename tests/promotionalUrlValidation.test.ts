import { describe, expect, it } from "vitest";
import {
  getSupportedProofLinkHint,
  validateProofLinkForChannels,
  validateProofLinksForChannels,
} from "../shared/promotionalUrlValidation";

describe("promotional proof link validation", () => {
  it("accepts proof links from selected social channels", () => {
    expect(validateProofLinkForChannels("https://x.com/roxonn/status/1", ["Twitter"]).valid).toBe(true);
    expect(validateProofLinkForChannels("https://www.linkedin.com/posts/roxonn", ["LinkedIn"]).valid).toBe(true);
    expect(validateProofLinkForChannels("https://youtu.be/demo", ["YouTube"]).valid).toBe(true);
    expect(validateProofLinkForChannels("https://www.tiktok.com/@roxonn/video/1", ["TikTok"]).valid).toBe(true);
  });

  it("rejects URLs that do not match the selected channel hostname", () => {
    expect(validateProofLinkForChannels("https://twitter.com.evil.test/post", ["Twitter"]).valid).toBe(false);
    expect(validateProofLinkForChannels("https://linkedin.com.evil.test/post", ["LinkedIn"]).valid).toBe(false);
    expect(validateProofLinkForChannels("https://youtube.com.evil.test/watch", ["YouTube"]).valid).toBe(false);
  });

  it("requires HTTPS for generic promotional channels", () => {
    expect(validateProofLinkForChannels("https://example.com/post", ["Blog"]).valid).toBe(true);
    expect(validateProofLinkForChannels("http://example.com/post", ["Blog"]).valid).toBe(false);
  });

  it("validates all submitted proof links", () => {
    const result = validateProofLinksForChannels(
      ["https://x.com/roxonn/status/1", "https://facebook.com.evil.test/post"],
      ["Twitter", "Facebook"]
    );

    expect(result.valid).toBe(false);
  });

  it("accepts links when any selected channel matches mixed generic and social channels", () => {
    expect(validateProofLinkForChannels("http://x.com/roxonn/status/1", ["Twitter", "Blog"]).valid).toBe(true);
    expect(validateProofLinkForChannels("https://example.com/post", ["Twitter", "Blog"]).valid).toBe(true);
    expect(validateProofLinkForChannels("http://example.com/post", ["Twitter", "Blog"]).valid).toBe(false);
  });

  it("rejects unsupported channel names instead of bypassing hostname validation", () => {
    const result = validateProofLinkForChannels("https://example.com/post", ["Newsletter"]);

    expect(result.valid).toBe(false);
    expect(result.message).toBe("Unsupported promotional channel.");
  });

  it("returns helpful supported-domain hints", () => {
    expect(getSupportedProofLinkHint(["Twitter", "YouTube"])).toContain("twitter.com");
    expect(getSupportedProofLinkHint(["Twitter", "YouTube"])).toContain("youtube.com");
    expect(getSupportedProofLinkHint(["Twitter", "Blog"])).toContain("Use HTTPS for Blog");
  });
});

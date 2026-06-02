export type PromotionalUrlValidationResult = {
  valid: boolean;
  message?: string;
};

const CHANNEL_DOMAINS: Record<string, string[]> = {
  twitter: ["twitter.com", "x.com"],
  "twitter/x": ["twitter.com", "x.com"],
  x: ["twitter.com", "x.com"],
  linkedin: ["linkedin.com"],
  youtube: ["youtube.com", "youtu.be"],
  instagram: ["instagram.com"],
  tiktok: ["tiktok.com"],
  facebook: ["facebook.com"],
};

const GENERIC_HTTPS_CHANNELS = new Set(["blog", "forum", "other"]);

function normalizeChannel(channel: string): string {
  return channel.trim().toLowerCase();
}

function hostnameMatches(hostname: string, allowedDomain: string): boolean {
  return hostname === allowedDomain || hostname.endsWith(`.${allowedDomain}`);
}

export function getSupportedProofLinkHint(channels: string[]): string {
  const domains = channels
    .flatMap((channel) => CHANNEL_DOMAINS[normalizeChannel(channel)] ?? [])
    .filter((domain, index, all) => all.indexOf(domain) === index);
  const hasGenericChannel = channels.some((channel) => GENERIC_HTTPS_CHANNELS.has(normalizeChannel(channel)));
  const hasRecognizedChannel = hasGenericChannel || domains.length > 0;

  if (!hasRecognizedChannel) {
    return "No recognized promotional channels were provided.";
  }

  if (hasGenericChannel && domains.length > 0) {
    return `Use HTTPS for Blog, Forum, or Other links, or a valid proof link from: ${domains.join(", ")}.`;
  }

  if (hasGenericChannel) {
    return "Use a valid HTTPS URL for the selected channel.";
  }

  if (domains.length === 0) {
    return "No recognized promotional channels were provided.";
  }

  return `Use a valid proof link from: ${domains.join(", ")}.`;
}

export function validateProofLinkForChannels(
  proofLink: string,
  channels: string[]
): PromotionalUrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(proofLink.trim());
  } catch {
    return { valid: false, message: "Proof link must be a valid URL." };
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { valid: false, message: "Only HTTP and HTTPS proof links are allowed." };
  }

  const normalizedChannels = channels.map(normalizeChannel);
  const hasGenericChannel = normalizedChannels.some((channel) => GENERIC_HTTPS_CHANNELS.has(channel));
  const allowedDomains = normalizedChannels.flatMap((channel) => CHANNEL_DOMAINS[channel] ?? []);
  const hasRecognizedChannel = hasGenericChannel || allowedDomains.length > 0;

  if (!hasRecognizedChannel) {
    return { valid: false, message: "No recognized promotional channels were provided." };
  }

  if (hasGenericChannel && parsed.protocol === "https:") {
    return { valid: true };
  }

  if (allowedDomains.length === 0) {
    if (hasGenericChannel) {
      return { valid: false, message: "Blog, forum, and other proof links must use HTTPS." };
    }
    return { valid: true };
  }

  const hostname = parsed.hostname.toLowerCase();
  const valid = allowedDomains.some((domain) => hostnameMatches(hostname, domain));
  if (!valid) {
    return {
      valid: false,
      message: hasGenericChannel && parsed.protocol !== "https:"
        ? "Blog, forum, and other proof links must use HTTPS."
        : getSupportedProofLinkHint(channels),
    };
  }

  return { valid: true };
}

export function validateProofLinksForChannels(
  proofLinks: string[],
  channels: string[]
): PromotionalUrlValidationResult {
  for (const proofLink of proofLinks) {
    const result = validateProofLinkForChannels(proofLink, channels);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}

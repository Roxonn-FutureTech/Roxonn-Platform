import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function decodeBase64(str: string): string {
  // Remove any whitespace
  let base64 = str.replace(/\s/g, '');

  // Convert from base64url to base64
  base64 = base64.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding
  while (base64.length % 4) {
    base64 += '=';
  }

  try {
    return atob(base64);
  } catch (error) {
    throw new Error(`Invalid base64 string: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export function base64ToUint8Array(str: string): Uint8Array {
  const binaryString = decodeBase64(str);
  return Uint8Array.from(binaryString, c => c.charCodeAt(0));
}

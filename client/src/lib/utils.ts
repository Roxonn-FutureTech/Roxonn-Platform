import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility functions for various client-side operations
 */

/**
 * Get CSRF token from cookies
 * Used for protected API endpoints that require CSRF protection
 * 
 * @returns {string | null} The CSRF token if found, null otherwise
 */
export function getCsrfToken(): string | null {
  const getCookie = (name: string) => {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop()?.split(';').shift();
  };

  // Try to get CSRF token from multiple possible cookie names
  const csrfToken = getCookie('csrfToken') || getCookie('_csrf');
  
  return csrfToken || null;
}

/**
 * Get a cookie value by name
 * 
 * @param {string} name Name of the cookie to retrieve
 * @returns {string | undefined} The cookie value if found, undefined otherwise
 */
export function getCookie(name: string): string | undefined {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop()?.split(';').shift();
}

/**
 * Format large numbers with commas for better readability
 * 
 * @param {number} num Number to format
 * @returns {string} Formatted number string
 */
export function formatNumber(num: number): string {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Truncate a string to a specified length with ellipsis
 *
 * @param {string} str String to truncate
 * @param {number} maxLength Maximum length of the string
 * @returns {string} Truncated string with ellipsis if needed
 */
export function truncateString(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Combines tailwind classes using clsx and merges them with twMerge
 * This prevents duplicate and conflicting classes
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Decode a Base64 string to its original form
 * Used for decrypting encrypted wallet data
 *
 * @param base64Str Base64 encoded string to decode
 * @returns Decoded string
 */
export function decodeBase64(base64Str: string): string {
  try {
    // Add padding if needed
    const paddedStr = base64Str.padEnd(
      Math.ceil(base64Str.length / 4) * 4,
      '='
    );

    // Decode base64 string to bytes, then convert to UTF-8 string
    return atob(paddedStr);
  } catch (error) {
    console.error('Error decoding Base64 string:', error);
    throw error;
  }
}

/**
 * Convert a Base64 encoded string to Uint8Array
 * Used for cryptographic operations with encrypted wallet data
 *
 * @param base64Str Base64 encoded string to convert
 * @returns Uint8Array representation of the Base64 string
 */
export function base64ToUint8Array(base64Str: string): Uint8Array {
  try {
    // Decode the base64 string to bytes
    const decodedStr = atob(base64Str);

    // Convert the string to a Uint8Array
    const uint8Array = new Uint8Array(decodedStr.length);
    for (let i = 0; i < decodedStr.length; i++) {
      uint8Array[i] = decodedStr.charCodeAt(i);
    }

    return uint8Array;
  } catch (error) {
    console.error('Error converting Base64 string to Uint8Array:', error);
    throw error;
  }
}
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
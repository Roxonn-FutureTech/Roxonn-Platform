import { STAGING_API_URL } from "../config";
import csrfService from "./csrf";

// Hardcode the staging API URL to fix CORS issues

/**
 * Utility for making API requests with credentials
 */
const api = {
  /**
   * Make a GET request to the API
   */
  async get<T = any>(endpoint: string): Promise<T> {
    const response = await fetch(`${STAGING_API_URL}${endpoint}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      const errorMessage = errorData.error || errorData.message || `HTTP ${response.status}`;
      console.error('API GET Error:', {
        endpoint,
        status: response.status,
        errorData
      });
      throw new Error(errorMessage);
    }

    return response.json();
  },
  
  /**
   * Make a POST request to the API
   */
  async post<T = any>(endpoint: string, data?: any): Promise<T> {
    // Add CSRF token to request data
    const csrfBody = data ? await csrfService.addTokenToBody(data) : { _csrf: await csrfService.getToken() };

    const response = await fetch(`${STAGING_API_URL}${endpoint}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': await csrfService.getToken() // Also include in headers for flexibility
      },
      body: JSON.stringify(csrfBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      const errorMessage = errorData.error || errorData.message || `HTTP ${response.status}`;
      console.error('API POST Error:', {
        endpoint,
        status: response.status,
        errorData,
        requestBody: csrfBody
      });
      throw new Error(errorMessage);
    }

    return response.json();
  },
  
  /**
   * Make a PUT request to the API
   */
  async put<T = any>(endpoint: string, data?: any): Promise<T> {
    // Add CSRF token to request data
    const csrfBody = data ? await csrfService.addTokenToBody(data) : { _csrf: await csrfService.getToken() };

    const response = await fetch(`${STAGING_API_URL}${endpoint}`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': await csrfService.getToken() // Also include in headers for flexibility
      },
      body: JSON.stringify(csrfBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      const errorMessage = errorData.error || errorData.message || `HTTP ${response.status}`;
      console.error('API PUT Error:', {
        endpoint,
        status: response.status,
        errorData,
        requestBody: csrfBody
      });
      throw new Error(errorMessage);
    }

    return response.json();
  },
  
  /**
   * Make a PATCH request to the API
   */
  async patch<T = any>(endpoint: string, data?: any): Promise<T> {
    // Add CSRF token to request data
    const csrfBody = data ? await csrfService.addTokenToBody(data) : { _csrf: await csrfService.getToken() };

    const response = await fetch(`${STAGING_API_URL}${endpoint}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': await csrfService.getToken() // Also include in headers for flexibility
      },
      body: JSON.stringify(csrfBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      const errorMessage = errorData.error || errorData.message || `HTTP ${response.status}`;
      console.error('API PATCH Error:', {
        endpoint,
        status: response.status,
        errorData,
        requestBody: csrfBody
      });
      throw new Error(errorMessage);
    }

    return response.json();
  },
  
  /**
   * Make a DELETE request to the API
   */
  async delete<T = any>(endpoint: string): Promise<T> {
    const response = await fetch(`${STAGING_API_URL}${endpoint}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-CSRF-Token': await csrfService.getToken() // Include in headers for DELETE requests
      }
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      const errorMessage = errorData.error || errorData.message || `HTTP ${response.status}`;
      console.error('API DELETE Error:', {
        endpoint,
        status: response.status,
        errorData
      });
      throw new Error(errorMessage);
    }

    return response.json();
  }
};

export default api; 
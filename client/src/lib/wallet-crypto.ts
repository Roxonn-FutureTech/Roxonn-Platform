// Using Web Crypto API for secure client-side encryption/decryption
import { base64ToUint8Array } from "./utils";

// Interface for encryption metadata with required salt
interface EncryptionMetadata {
  salt: string;
  // Add other encryption parameters as needed
  iterations?: number;
  algorithm?: string;
}

export async function decryptPrivateKey(
  encryptedData: string,
  password: string,
  metadata: EncryptionMetadata
): Promise<string> {
  try {
    // Convert base64 encrypted data to array buffer
    const encryptedBytes = base64ToUint8Array(encryptedData);

    // Convert password to key using PBKDF2
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    // Salt must be provided in metadata for security
    if (!metadata?.salt) {
      throw new Error('Encryption salt is required for decryption');
    }
    const salt = base64ToUint8Array(metadata.salt);

    // Generate key from password
    const key = await window.crypto.subtle.importKey(
      'raw',
      passwordBuffer,
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    const derivedKey = await window.crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      key,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );

    // Extract IV from the beginning of encrypted data (first 12 bytes)
    const iv = encryptedBytes.slice(0, 12);
    const ciphertext = encryptedBytes.slice(12);

    // Decrypt
    const decrypted = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv
      },
      derivedKey,
      ciphertext
    );

    // Convert result to string
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt private key. Check your password.');
  }
}

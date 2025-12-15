// Helper for ECDH envelope encryption on the client side
import { base64ToUint8Array, decodeBase64 } from "./utils";

// P-256 is supported by all evergreen browsers

export async function generateEphemeralKeyPair(): Promise<{
  publicKeyBase64: string;
  privateKey: CryptoKey;
}> {
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    ['deriveBits']
  );
  const rawPub = await window.crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyBase64 = bufferToBase64(rawPub);
  return { publicKeyBase64, privateKey: keyPair.privateKey };
}

export async function deriveSharedSecret(
  privateKey: CryptoKey,
  serverPublicKeyBase64: string
): Promise<ArrayBuffer> {
  const serverPubBuf = base64ToArrayBuffer(serverPublicKeyBase64);
  const serverPubKey = await window.crypto.subtle.importKey(
    'raw',
    serverPubBuf,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  return await window.crypto.subtle.deriveBits(
    {
      name: 'ECDH',
      public: serverPubKey
    },
    privateKey,
    256
  );
}

export async function decryptWithSharedSecret(
  cipherTextBase64: string,
  ivBase64: string,
  sharedSecret: ArrayBuffer
): Promise<string> {
  // Derive AES-256 key by hashing the secret with SHA-256 (same as server)
  const hash = await window.crypto.subtle.digest('SHA-256', sharedSecret);
  const aesKey = await window.crypto.subtle.importKey(
    'raw',
    hash,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const iv = base64ToArrayBuffer(ivBase64);
  const cipherBytes = base64ToArrayBuffer(cipherTextBase64);

  const plainBuf = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv },
    aesKey,
    cipherBytes
  );
  const decoder = new TextDecoder();
  return decoder.decode(plainBuf);
}

function bufferToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  return base64ToUint8Array(base64).buffer as ArrayBuffer;
}

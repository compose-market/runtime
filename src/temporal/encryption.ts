/**
 * Temporal Data Converter with Encryption Support
 * 
 * Provides payload encryption/decryption for sensitive data in Temporal Cloud.
 * Uses AES-256-GCM for encryption with environment-derived keys.
 * 
 * This is an advanced security feature that ensures Temporal Cloud cannot read
 * sensitive business data stored in workflow histories.
 * 
 * NOTE: This is a scaffolding implementation. For production use, integrate
 * with Temporal SDK's actual DataConverter interface after upgrading dependencies.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

// Encryption configuration
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

interface EncryptedPayload {
    ciphertext: string; // base64
    iv: string; // base64
    authTag: string; // base64
}

/**
 * Derive encryption key from environment variable
 * Uses scrypt for key derivation with a fixed salt (salt should be rotated periodically)
 */
function deriveEncryptionKey(): Buffer {
    const envKey = process.env.TEMPORAL_PAYLOAD_ENCRYPTION_KEY;
    
    if (!envKey) {
        // Return null to indicate encryption is disabled
        return Buffer.alloc(0);
    }
    
    // Use a fixed salt - in production, this should be stored securely and rotated
    const salt = Buffer.from("temporal-compose-market-salt-v1", "utf8");
    
    // Derive 256-bit key using scrypt
    return scryptSync(envKey, salt, KEY_LENGTH);
}

/**
 * Check if encryption is enabled
 */
export function isEncryptionEnabled(): boolean {
    const key = deriveEncryptionKey();
    return key.length > 0;
}

/**
 * Encrypt a payload
 */
function encryptPayload(data: Buffer, key: Buffer): EncryptedPayload {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    
    return {
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
    };
}

/**
 * Decrypt a payload
 */
function decryptPayload(encrypted: EncryptedPayload, key: Buffer): Buffer {
    const decipher = createDecipheriv(
        ENCRYPTION_ALGORITHM,
        key,
        Buffer.from(encrypted.iv, "base64")
    );
    
    decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
    
    return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final(),
    ]);
}

/**
 * Encryption utilities for payload data
 */
export const encryptionUtils = {
    encrypt: (data: string): EncryptedPayload => {
        const key = deriveEncryptionKey();
        if (key.length === 0) {
            throw new Error("Encryption key not configured");
        }
        return encryptPayload(Buffer.from(data, "utf8"), key);
    },
    
    decrypt: (encrypted: EncryptedPayload): string => {
        const key = deriveEncryptionKey();
        if (key.length === 0) {
            throw new Error("Encryption key not configured");
        }
        return decryptPayload(encrypted, key).toString("utf8");
    },
};

/**
 * Validation function to check encryption setup
 */
export function validateEncryptionSetup(): { enabled: boolean; warning?: string } {
    const enabled = isEncryptionEnabled();
    
    if (!enabled) {
        return {
            enabled: false,
            warning: "Payload encryption is disabled. Set TEMPORAL_PAYLOAD_ENCRYPTION_KEY for production use.",
        };
    }
    
    return { enabled: true };
}

/**
 * Get encryption status for logging
 */
export function getEncryptionStatus(): string {
    if (isEncryptionEnabled()) {
        return "[temporal/encryption] Payload encryption AVAILABLE - set TEMPORAL_PAYLOAD_ENCRYPTION_KEY to enable";
    }
    return "[temporal/encryption] Payload encryption DISABLED - set TEMPORAL_PAYLOAD_ENCRYPTION_KEY to enable";
}

// Export encryption scaffolding for future DataConverter integration
export { deriveEncryptionKey, encryptPayload, decryptPayload };

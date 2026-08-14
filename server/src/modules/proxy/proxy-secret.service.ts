import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

@Injectable()
export class ProxySecretService {
  constructor(private readonly config: ConfigService) {}

  encrypt(value: string, setting = 'PROXY_SECRET_ENCRYPTION_KEY'): EncryptedSecret {
    const key = this.key(setting);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { ciphertext: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  decrypt(secret: EncryptedSecret, setting = 'PROXY_SECRET_ENCRYPTION_KEY') {
    const decipher = createDecipheriv('aes-256-gcm', this.key(setting), Buffer.from(secret.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }

  decryptProviderKey(row: { secret_ciphertext: string; secret_iv: string; secret_tag: string }) {
    return this.decrypt({ ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag }, 'PROVIDER_SECRET_ENCRYPTION_KEY');
  }

  private key(setting: string) {
    const configured = this.config.get<string>(setting);
    if (!configured || configured.length < 32) throw new Error(`${setting} must contain at least 32 characters`);
    return createHash('sha256').update(configured).digest();
  }
}

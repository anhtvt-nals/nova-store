import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ProxySecretService } from './proxy-secret.service';

@Injectable()
export class ProxyCredentialService {
  constructor(private readonly db: DatabaseService, private readonly secrets: ProxySecretService) {}

  async getOrCreate(profileId: number): Promise<{ username: string; password: string }> {
    const existing = await this.load(profileId);
    if (existing) return existing;
    const username = this.randomAlphaNumeric(10);
    const password = this.randomAlphaNumeric(10);
    const encrypted = this.secrets.encrypt(password);
    const inserted = await this.db.client.from('proxy_account_credentials').insert({
      profile_id: profileId,
      username,
      password_ciphertext: encrypted.ciphertext,
      password_iv: encrypted.iv,
      password_tag: encrypted.tag,
    });
    if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
    return (await this.load(profileId))!;
  }

  async get(profileId: number) {
    return this.load(profileId);
  }

  private async load(profileId: number): Promise<{ username: string; password: string } | null> {
    const result = await this.db.client.from('proxy_account_credentials')
      .select('username,password_ciphertext,password_iv,password_tag')
      .eq('profile_id', profileId).maybeSingle();
    const row = this.db.unwrap(result, 'Unable to load proxy account credential');
    if (!row) return null;
    return {
      username: row.username,
      password: this.secrets.decrypt({ ciphertext: row.password_ciphertext, iv: row.password_iv, tag: row.password_tag }),
    };
  }

  private randomAlphaNumeric(length: number) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');
  }
}

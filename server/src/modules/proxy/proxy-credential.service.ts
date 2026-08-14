import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ProxySecretService } from './proxy-secret.service';

@Injectable()
export class ProxyCredentialService {
  constructor(private readonly db: DatabaseService, private readonly secrets: ProxySecretService) {}

  async getOrCreate(profileId: number): Promise<{ username: string; password: string }> {
    const existing = await this.load(profileId);
    if (existing) return existing;
    const username = `px_${randomBytes(8).toString('base64url')}`;
    const password = randomBytes(24).toString('base64url');
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
}


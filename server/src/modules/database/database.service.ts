import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type PostgrestError, type SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class DatabaseService {
  readonly client: SupabaseClient;

  constructor(config: ConfigService) {
    const url = config.get<string>('SUPABASE_URL');
    const key = config.get<string>('SUPABASE_SECRET_KEY') || config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required');
    this.client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  }

  unwrap<T>(result: { data: T | null; error: PostgrestError | null }, context: string): T {
    if (result.error) throw new InternalServerErrorException(`${context}: ${result.error.message}`);
    return result.data as T;
  }
}

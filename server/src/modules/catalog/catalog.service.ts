import { Injectable } from '@nestjs/common';
import { mapPlan, mapResource } from '../../common/mappers';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class CatalogService {
  constructor(private db: DatabaseService) {}

  async plans() {
    const result = await this.db.client.from('plans').select('id,product_id,name,description,price,duration_hours,rotation_minutes,highlighted,config,products(code,name,service_type,description,base_price,currency)').eq('is_active', true).order('sort_order');
    return this.db.unwrap(result, 'Unable to load plans').map(mapPlan);
  }

  async products() {
    const result = await this.db.client.from('products').select('id,code,name,service_type,country_code,description,base_price,currency,image_url,is_featured').eq('is_active', true).order('country_code').order('name');
    return this.db.unwrap(result, 'Unable to load products').map(row => ({
      id: row.id,
      code: row.code,
      name: row.name,
      serviceType: row.service_type,
      countryCode: row.country_code,
      description: row.description,
      unitPrice: Number(row.base_price),
      currency: row.currency,
      imageUrl: row.image_url,
      isFeatured: row.is_featured,
    }));
  }

  async resources() {
    const result = await this.db.client.from('resources').select('id,product_id,name,region,status,capabilities,health').eq('is_public', true).order('name');
    return this.db.unwrap(result, 'Unable to load resources').map(mapResource);
  }
}

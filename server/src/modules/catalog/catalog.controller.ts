import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { CatalogService } from './catalog.service';

@Public()
@Controller('catalog')
export class CatalogController {
  constructor(private service: CatalogService) {}
  @Get('products') products() { return this.service.products(); }
  @Get('plans') plans() { return this.service.plans(); }
  @Get('settings') settings() { return this.service.settings(); }
  @Get('resources') resources() { return this.service.resources(); }
}

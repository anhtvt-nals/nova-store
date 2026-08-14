import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class CreateUserDto {
  @IsString() @Length(2, 100) name: string;
  @IsEmail() email: string;
  @IsString() @Length(12, 72) password: string;
}
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsIn(['active', 'suspended']) status?: 'active' | 'suspended';
}
export class CreateApiKeyDto {
  @IsString() @Length(2, 100) label: string;
}
export class UpdateOrderStatusDto {
  @IsIn(['active', 'rejected']) status: 'active' | 'rejected';
}

export class CreateCategoryDto {
  @IsString() @Length(2, 80) name: string;
  @IsString() @Length(2, 80) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateCategoryDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsString() @Length(2, 80) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) slug?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}

export class CreateProductDto {
  @IsInt() @Min(1) categoryId: number;
  @IsString() @Length(2, 80) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) code: string;
  @IsString() @Length(2, 100) name: string;
  @IsOptional() @IsString() @Length(0, 80) sku?: string;
  @IsOptional() @IsString() @Length(0, 1000) description?: string;
  @IsIn(['account', 'digital', 'service', 'other']) productKind: 'account' | 'digital' | 'service' | 'other';
  @IsIn(['automatic', 'manual', 'service']) fulfillmentType: 'automatic' | 'manual' | 'service';
  @IsString() @Length(2, 50) serviceType: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) basePrice: number;
  @IsString() @Matches(/^[A-Z]{3}$/) currency: string;
  @IsOptional() @IsInt() @Min(0) stockQuantity?: number;
  @IsOptional() @IsString() @Length(0, 1000) imageUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
}

export class UpdateProductDto {
  @IsOptional() @IsInt() @Min(1) categoryId?: number;
  @IsOptional() @IsString() @Length(2, 80) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) code?: string;
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @Length(0, 80) sku?: string;
  @IsOptional() @IsString() @Length(0, 1000) description?: string;
  @IsOptional() @IsIn(['account', 'digital', 'service', 'other']) productKind?: 'account' | 'digital' | 'service' | 'other';
  @IsOptional() @IsIn(['automatic', 'manual', 'service']) fulfillmentType?: 'automatic' | 'manual' | 'service';
  @IsOptional() @IsString() @Length(2, 50) serviceType?: string;
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) basePrice?: number;
  @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) currency?: string;
  @IsOptional() @IsInt() @Min(0) stockQuantity?: number;
  @IsOptional() @IsString() @Length(0, 1000) imageUrl?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isFeatured?: boolean;
}

export class CreateProviderDto {
  @IsString() @Length(2, 100) name: string;
  @IsString() @Length(2, 60) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) code: string;
  @IsOptional() @IsString() @Length(0, 500) apiBaseUrl?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsInt() @Min(1) maxSandboxes?: number;
  @IsOptional() @IsInt() @Min(0) reservedReplacementSlots?: number;
  @IsOptional() @IsInt() @Min(1) maxConcurrentProvisions?: number;
}

export class UpdateProviderDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @Length(2, 60) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) code?: string;
  @IsOptional() @IsString() @Length(0, 500) apiBaseUrl?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsInt() @Min(1) maxSandboxes?: number;
  @IsOptional() @IsInt() @Min(0) reservedReplacementSlots?: number;
  @IsOptional() @IsInt() @Min(1) maxConcurrentProvisions?: number;
}

export class CreateProviderApiKeyDto {
  @IsString() @Length(2, 100) label: string;
  @IsString() @Length(8, 1000) secret: string;
}

export class UpdateProxyPriceDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) basePrice: number;
  @IsString() @Matches(/^[A-Z]{3}$/) currency: string;
}

export class UpdateGeneralSettingsDto {
  @IsString() @Length(2, 100) siteName: string;
  @IsOptional() @IsEmail() supportEmail?: string;
  @IsString() @Matches(/^[A-Z]{3}$/) defaultCurrency: string;
}

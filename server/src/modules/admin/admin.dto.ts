import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class CreateUserDto {
  @IsString() @Length(2, 100) name: string;
  @IsEmail() email: string;
}
export class UpdateUserDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsIn(['active', 'suspended']) status?: 'active' | 'suspended';
  @IsOptional() @IsBoolean() isTrial?: boolean;
}

export class AdjustCreditDto {
  @IsNumber({ maxDecimalPlaces: 2 }) amount: number;
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}
export class AddCreditTopUpDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsIn(['USD', 'IDR']) currency: 'USD' | 'IDR';
  @IsOptional() @IsString() @Length(0, 300) note?: string;
}
export class DeductCreditDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsString() @Length(1, 300) note: string;
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
  @IsOptional() @IsIn(['datacenter', 'residential']) proxyType?: 'datacenter' | 'residential';
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) basePrice: number;
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
  @IsOptional() @IsIn(['datacenter', 'residential']) proxyType?: 'datacenter' | 'residential';
  @IsOptional() @IsString() @Matches(/^[A-Z]{2}$/) countryCode?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) basePrice?: number;
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
  @IsOptional() @IsInt() @Min(1) maxSandboxes?: number | null;
  @IsOptional() @IsInt() @Min(0) reservedReplacementSlots?: number;
  @IsOptional() @IsInt() @Min(1) maxConcurrentProvisions?: number;
}

export class UpdateProviderDto {
  @IsOptional() @IsString() @Length(2, 100) name?: string;
  @IsOptional() @IsString() @Length(2, 60) @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) code?: string;
  @IsOptional() @IsString() @Length(0, 500) apiBaseUrl?: string;
  @IsOptional() @IsIn(['active', 'disabled']) status?: 'active' | 'disabled';
  @IsOptional() @IsInt() @Min(1) maxSandboxes?: number | null;
  @IsOptional() @IsInt() @Min(0) reservedReplacementSlots?: number;
  @IsOptional() @IsInt() @Min(1) maxConcurrentProvisions?: number;
}

export class CreateProviderApiKeyDto {
  @IsString() @Length(2, 100) label: string;
  @IsString() @Length(8, 1000) secret: string;
  @IsOptional() @IsInt() @Min(1) maxSandboxes?: number;
}

export class UpdateProviderApiKeyDto {
  @IsInt() @Min(1) maxSandboxes: number;
}

export class CreateBlaxelEgressGatewayDto {
  @IsInt() @Min(1) providerApiKeyId: number;
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,126}$/) name: string;
  @IsString() @Matches(/^[a-z]{2}-[a-z]+-[0-9]+$/) region: string;
}

export class UpdateBlaxelEgressGatewayDto {
  @IsIn(['active', 'disabled']) status: 'active' | 'disabled';
}

export class UpdateProxyPriceDto {
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) basePrice: number;
  @IsString() @Matches(/^[A-Z]{3}$/) currency: string;
}

export class UpdateGeneralSettingsDto {
  @IsString() @Length(2, 100) siteName: string;
  @IsOptional() @IsEmail() supportEmail?: string;
  @IsString() @Matches(/^[A-Z]{3}$/) defaultCurrency: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) usdToIdrRate: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) creditsPerUsd: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) trialCreditAmount: number;
}

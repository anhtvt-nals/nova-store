import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateStaticResidentialOrderDto {
  @IsInt() @IsIn([1, 3, 7, 15, 30]) rentalDays!: number;
}

export class ExtendStaticResidentialOrderDto {
  @IsInt() @IsIn([1, 3, 7, 15, 30]) rentalDays!: number;
}

export class ImportStaticResidentialProxiesDto {
  @IsString() @MaxLength(2_000_000) content!: string;
  @IsOptional() @IsString() @MaxLength(120) label?: string;
}

export class UpdateStaticResidentialPricingDto {
  @Min(0.0001) pricePerGbDay!: number;
}

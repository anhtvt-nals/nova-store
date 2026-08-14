import { IsIn, IsInt, IsPositive, Max, Min } from 'class-validator';

export class CreateOrderDto {
  @IsInt() @IsPositive() productId: number;
  @IsInt() @Min(1) @Max(100) nodeCount: number;
  @IsInt() @Min(1) @Max(365) rentalDays: number;
  @IsIn(['bank_transfer', 'crypto']) paymentMethod: 'bank_transfer' | 'crypto';
}

export class QuoteOrderDto {
  @IsInt() @IsPositive() productId: number;
  @IsInt() @Min(1) @Max(100) nodeCount: number;
  @IsInt() @Min(1) @Max(365) rentalDays: number;
}

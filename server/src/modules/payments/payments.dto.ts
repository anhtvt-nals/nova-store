import { IsIn, IsInt, Max, Min } from 'class-validator';

export class CreateSumopodCheckoutDto {
  @IsInt()
  @Min(10_000)
  @Max(10_000_000)
  amountIdr: number;

  @IsIn(['QRIS', 'QRIS_INSTANT'])
  paymentMethod: 'QRIS' | 'QRIS_INSTANT';
}

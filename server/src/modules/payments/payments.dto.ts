import { IsIn, IsInt, Min } from 'class-validator';

export class CreateSumopodCheckoutDto {
  @IsInt()
  @Min(1_000)
  amountIdr: number;

  @IsIn(['QRIS', 'QRIS_INSTANT'])
  paymentMethod: 'QRIS' | 'QRIS_INSTANT';
}

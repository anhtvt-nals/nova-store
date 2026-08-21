import { IsEmail, MaxLength } from 'class-validator';

export class TempMailMessagesDto {
  @IsEmail({}, { message: 'A valid temporary email address is required' })
  @MaxLength(254)
  address!: string;
}

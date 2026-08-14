import { Type } from 'class-transformer';
import { IsIn, IsInt, IsIP, IsISO8601, IsObject, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { PROXY_NODE_STATUSES, type ProxyNodeStatus } from './proxy.types';

export class ReportProxyNodeStatusDto {
  @IsIn(PROXY_NODE_STATUSES)
  status: ProxyNodeStatus;

  @IsOptional() @IsString() @Length(1, 500)
  instanceId?: string;

  @IsOptional() @IsIP()
  egressIp?: string;

  @IsOptional() @IsString() @Length(1, 500)
  publicHost?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535)
  tunnelPort?: number;

  @IsOptional() @IsISO8601()
  nextRotationAt?: string;

  @IsOptional() @IsObject()
  health?: Record<string, unknown>;

  @IsOptional() @IsString() @Length(1, 100)
  errorCode?: string;

  @IsOptional() @IsString() @Length(1, 2000)
  errorMessage?: string;
}


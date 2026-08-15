import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { Public } from '../auth/public.decorator';
import { GithubActionsControlPlaneService } from './provider/github-actions-control-plane.service';

class ClaimRunnerTaskDto { @IsInt() @Min(1) runId: number; }

@Public()
@Controller('internal/github-runners')
export class GithubRunnersController {
  constructor(private readonly controlPlane: GithubActionsControlPlaneService) {}

  @Post('tasks/:id/config')
  config(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Headers('authorization') authorization: string | undefined, @Body() body: ClaimRunnerTaskDto) {
    const token = authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new UnauthorizedException('Missing GitHub OIDC bearer token');
    return this.controlPlane.claim(id, token, body.runId);
  }
}

import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; role: string } {
    return { status: 'ok', role: process.env.ROLE ?? 'api' };
  }
}

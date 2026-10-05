import { Controller, Get } from '@nestjs/common';
import { Public } from '../app/http.js';

@Controller('health')
export class HealthController {
  @Public() @Get()
  check(): { status: 'ok'; role: string } {
    return { status: 'ok', role: process.env.ROLE ?? 'api' };
  }
}

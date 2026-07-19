import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verifySsoToken } from '@senimerp/auth-client';
import { SsoJwtPayload } from '@senimerp/types';
import { Request as ExpressRequest } from 'express';

/**
 * Custom request wrapper mapping the decoded SSO JWT payload.
 */
export interface RequestWithUser extends ExpressRequest {
  user: SsoJwtPayload;
}

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const authHeader = request.headers['authorization'] || '';
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization header with Bearer token is required');
    }

    const token = authHeader.substring(7); // Extract token from "Bearer ..."
    try {
      const decoded = verifySsoToken(token);
      request.user = decoded;
      return true;
    } catch (e) {
      throw new UnauthorizedException((e as Error).message);
    }
  }
}

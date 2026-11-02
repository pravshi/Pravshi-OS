/**
 * Pravshi OS  Mobile Navigation Routes & Route Guards.
 *
 * Strongly typed route definitions for authentication, multi-tenant switching,
 * operational dashboards, and offline sync state.
 */

export type AppRoute =
  | 'AUTH_LOGIN'
  | 'AUTH_BIOMETRIC_CHALLENGE'
  | 'DASHBOARD'
  | 'TENANT_SWITCHER'
  | 'OFFLINE_STATUS'
  | 'DOCUMENT_SCANNER';

export interface RouteConfig {
  name: AppRoute;
  path: string;
  title: string;
  requiresAuth: boolean;
  requiresTenant: boolean;
}

export const APP_ROUTES: Record<AppRoute, RouteConfig> = {
  AUTH_LOGIN: {
    name: 'AUTH_LOGIN',
    path: '/auth/login',
    title: 'Sign In',
    requiresAuth: false,
    requiresTenant: false,
  },
  AUTH_BIOMETRIC_CHALLENGE: {
    name: 'AUTH_BIOMETRIC_CHALLENGE',
    path: '/auth/biometric',
    title: 'Unlock Session',
    requiresAuth: false,
    requiresTenant: false,
  },
  DASHBOARD: {
    name: 'DASHBOARD',
    path: '/dashboard',
    title: 'Dashboard',
    requiresAuth: true,
    requiresTenant: true,
  },
  TENANT_SWITCHER: {
    name: 'TENANT_SWITCHER',
    path: '/tenant/switch',
    title: 'Select Organization',
    requiresAuth: true,
    requiresTenant: false,
  },
  OFFLINE_STATUS: {
    name: 'OFFLINE_STATUS',
    path: '/system/offline-queue',
    title: 'Offline Queue',
    requiresAuth: false,
    requiresTenant: false,
  },
  DOCUMENT_SCANNER: {
    name: 'DOCUMENT_SCANNER',
    path: '/scanner/documents',
    title: 'Scan Document',
    requiresAuth: true,
    requiresTenant: true,
  },
};

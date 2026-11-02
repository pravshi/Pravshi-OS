/**
 * Pravshi OS  Mobile Navigation State & Controller.
 *
 * Provides stack-based routing controller and route guard enforcement.
 */

import { useState, useCallback, useMemo } from 'react';
import { type AppRoute, APP_ROUTES, type RouteConfig } from './routes';
import type { SessionLifecycleState } from '../auth/session';

export interface NavigationState {
  currentRoute: AppRoute;
  params?: Record<string, unknown>;
  history: AppRoute[];
}

export interface NavigationController {
  currentRoute: AppRoute;
  currentConfig: RouteConfig;
  navigate: (route: AppRoute, params?: Record<string, unknown>) => void;
  goBack: () => boolean;
  canGoBack: boolean;
}

export function useMobileNavigation(
  sessionLifecycle: SessionLifecycleState,
  hasActiveTenant: boolean,
): NavigationController {
  // Determine initial route based on auth state
  const getInitialRoute = (): AppRoute => {
    if (sessionLifecycle === 'REAUTHENTICATION_REQUIRED') {
      return 'AUTH_BIOMETRIC_CHALLENGE';
    }
    if (sessionLifecycle === 'AUTHENTICATED') {
      return hasActiveTenant ? 'DASHBOARD' : 'TENANT_SWITCHER';
    }
    return 'AUTH_LOGIN';
  };

  const [state, setState] = useState<NavigationState>(() => ({
    currentRoute: getInitialRoute(),
    history: [],
  }));

  const navigate = useCallback((route: AppRoute, params?: Record<string, unknown>) => {
    setState((prev) => ({
      currentRoute: route,
      params,
      history: [...prev.history, prev.currentRoute],
    }));
  }, []);

  const goBack = useCallback((): boolean => {
    if (state.history.length === 0) return false;
    setState((prev) => {
      const nextHistory = [...prev.history];
      const previousRoute = nextHistory.pop()!;
      return {
        currentRoute: previousRoute,
        history: nextHistory,
      };
    });
    return true;
  }, [state.history]);

  const currentConfig = useMemo(() => APP_ROUTES[state.currentRoute], [state.currentRoute]);

  return {
    currentRoute: state.currentRoute,
    currentConfig,
    navigate,
    goBack,
    canGoBack: state.history.length > 0,
  };
}

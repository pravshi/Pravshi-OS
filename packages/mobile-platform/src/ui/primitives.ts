/**
 * Pravshi OS  Mobile Platform UI Primitives & Styling Contracts.
 *
 * Defines cross-platform layout, typography, and surface contracts
 * consumed by mobile screens and custom brandable components.
 */

import type { CSSProperties } from 'react';
import type { ThemeTokens } from './tokens';

export interface MobileViewStyle {
  display?: 'flex' | 'none' | 'inline-flex';
  flex?: number;
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
  justifyContent?:
    'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around' | 'space-evenly';
  alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';
  alignSelf?: 'auto' | 'flex-start' | 'flex-end' | 'center' | 'stretch' | 'baseline';
  gap?: number | string;
  padding?: number | string;
  paddingHorizontal?: number | string;
  paddingVertical?: number | string;
  paddingTop?: number | string;
  paddingBottom?: number | string;
  paddingLeft?: number | string;
  paddingRight?: number | string;
  margin?: number | string;
  marginHorizontal?: number | string;
  marginVertical?: number | string;
  marginTop?: number | string;
  marginBottom?: number | string;
  marginLeft?: number | string;
  marginRight?: number | string;
  backgroundColor?: string;
  borderRadius?: number;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
  width?: number | string;
  height?: number | string;
  minWidth?: number | string;
  minHeight?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  position?: 'relative' | 'absolute';
  top?: number | string;
  bottom?: number | string;
  left?: number | string;
  right?: number | string;
  zIndex?: number;
  overflow?: 'visible' | 'hidden' | 'scroll';
}

export interface MobileTextStyle {
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: '400' | '500' | '600' | '700';
  lineHeight?: number;
  textAlign?: 'auto' | 'left' | 'right' | 'center' | 'justify';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  letterSpacing?: number;
  margin?: number | string;
  marginTop?: number | string;
  marginBottom?: number | string;
  marginLeft?: number | string;
  marginRight?: number | string;
}

/**
 * Maps a MobileViewStyle or MobileTextStyle into standard CSS properties for DOM or Web fallbacks.
 */
export function toCssProperties(style?: MobileViewStyle | MobileTextStyle): CSSProperties {
  if (!style) return {};
  const css: Record<string, string | number> = {};

  for (const [key, val] of Object.entries(style)) {
    if (val === undefined) continue;

    if (key === 'paddingHorizontal') {
      css.paddingLeft = val;
      css.paddingRight = val;
    } else if (key === 'paddingVertical') {
      css.paddingTop = val;
      css.paddingBottom = val;
    } else if (key === 'marginHorizontal') {
      css.marginLeft = val;
      css.marginRight = val;
    } else if (key === 'marginVertical') {
      css.marginTop = val;
      css.marginBottom = val;
    } else {
      css[key] = val;
    }
  }

  return css as CSSProperties;
}

export function createSurfaceStyle(
  theme: ThemeTokens,
  variant: 'elevated' | 'flat' | 'outline' = 'flat',
): MobileViewStyle {
  switch (variant) {
    case 'elevated':
      return {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.md,
        borderColor: theme.colors.borderSubtle,
        borderWidth: 1,
      };
    case 'outline':
      return {
        backgroundColor: 'transparent',
        borderRadius: theme.borderRadius.md,
        borderColor: theme.colors.border,
        borderWidth: 1,
      };
    case 'flat':
    default:
      return {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.borderRadius.md,
      };
  }
}

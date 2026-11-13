// Geometric 2px-stroke Lucide icon wrapper with semantic size presets and screen-reader hiding.
import React from 'react';
import { ICON_MAP } from './icon-names';

const SIZE_MAP = {
  sm: 16,
  md: 18,
  lg: 20,
};

export default function Icon({
  name,
  size = 'md',
  className = '',
  strokeWidth = 2,
  ...rest
}) {
  const IconComponent = ICON_MAP[name];
  if (!IconComponent) {
    if (import.meta.env.DEV) {
      console.warn(`[Icon] Unknown icon "${name}". Add it to src/components/icon-names.js.`);
    }
    return null;
  }

  const pixelSize = typeof size === 'number' ? size : (SIZE_MAP[size] ?? SIZE_MAP.md);
  const classes = ['as-icon', className].filter(Boolean).join(' ');

  return (
    <IconComponent
      size={pixelSize}
      strokeWidth={strokeWidth}
      aria-hidden="true"
      focusable="false"
      className={classes}
      {...rest}
    />
  );
}

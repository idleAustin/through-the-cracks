// Precision floating tooltip wrapper displaying an action label and optional shortcut on hover or focus.
import React from 'react';

const POSITION_CLASS = {
  top: '',
  left: 'tip-left',
  down: 'tip-down',
  'down-left': 'tip-down tip-left',
};

export default function Tooltip({ label, shortcut = '', position = 'top', children }) {
  const wrapperClass = ['tooltip-wrapper', POSITION_CLASS[position] || ''].filter(Boolean).join(' ');

  return (
    <span className={wrapperClass}>
      {children}
      <span className="tooltip-bubble" role="tooltip">
        <span>{label}</span>
        {shortcut ? <kbd className="kbd">{shortcut}</kbd> : null}
      </span>
    </span>
  );
}

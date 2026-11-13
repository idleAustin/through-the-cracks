// Precision floating tooltip wrapper displaying an action label on hover or keyboard focus.
import React from 'react';

const POSITION_CLASS = {
  top: '',
  left: 'tip-left',
  down: 'tip-down',
  'down-left': 'tip-down tip-left',
};

export default function Tooltip({ label, position = 'top', children }) {
  const wrapperClass = ['tooltip-wrapper', POSITION_CLASS[position] || ''].filter(Boolean).join(' ');

  return (
    <span className={wrapperClass}>
      {children}
      <span className="tooltip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}

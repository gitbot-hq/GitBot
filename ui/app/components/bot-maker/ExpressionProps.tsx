'use client';

import { useId } from 'react';
import artwork from './artwork.json';

// Props sit in front of the face, but do not inherit its blink or gaze movement.
export default function ExpressionProps({ expression }: { expression: string }) {
  const id = useId();
  return <>{artwork.accessories.map(prop => <svg key={prop.id} className="bm-accessories" data-prop={prop.id} data-active={expression === prop.id} viewBox="0 0 78 104" fill="none" aria-hidden="true" dangerouslySetInnerHTML={{ __html: prop.markup.replaceAll('__mascot_id__', `${id}-${prop.id}-`) }} />)}</>;
}

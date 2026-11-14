import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <p className="font-mono text-5xl text-accent" aria-hidden>404</p>
      <h1 className="mt-4 text-2xl font-semibold">Nothing here</h1>
      <p className="mt-2 text-sm text-muted">This page does not exist. Like a webhook endpoint after 24 hours of silence.</p>
      <p className="mt-6"><Link to="/" className="btn btn-primary">Back home</Link></p>
    </div>
  );
}

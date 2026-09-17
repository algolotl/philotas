/** @type {import('next').NextConfig} */
const nextConfig = {
  // The map element is a long-lived imperative MapLibre instance; React strict
  // mode's double-invoke of effects would init it twice in dev. Off by choice.
  reactStrictMode: false,
};

export default nextConfig;

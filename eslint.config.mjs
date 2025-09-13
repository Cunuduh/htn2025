import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      // Allow explicit any for rapid prototyping / hackathon speed.
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow ts-ignore usage.
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': false }],
    },
  },
];

export default eslintConfig;

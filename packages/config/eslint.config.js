// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Base flat-config shared by every vektor-platform package. A package that
 * needs framework-specific rules (Next.js, React) extends this array rather
 * than starting over.
 */
export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", ".next/**", ".turbo/**", "node_modules/**"],
  },
);

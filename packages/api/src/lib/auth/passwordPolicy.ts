// Kept out of `password.ts` on purpose: that module imports the native `argon2` binding, and a
// `.svelte` page needs this constant client-side (the min-length hint and `minlength` attribute)
// without pulling the Argon2 loader into the browser bundle.

/** The shortest password `/auth/reset` accepts (§5.2: no policy beyond a sane floor). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The minlength the browser enforces on the password field. Only choosing a password (sign-up) is held to the server minimum: an account made while the
 * minimum was lower, or under another MIN_PASSWORD_LENGTH, must still be able to type its password and sign in. The server enforces the minimum again on
 * every change of password.
 */
export function passwordFieldMinLength(mode: "sign-in" | "sign-up" | "forgot", minimum: number) {
  return mode === "sign-up" ? minimum : 1;
}

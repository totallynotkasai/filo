/**
 * The one platform switch a characterisation spec may use.
 *
 * Filo targets Windows (and macOS). A few specs time out on the Linux CI
 * runner, where the file watcher reports another program's rename or save
 * right after Filo's own write differently. They pass on Windows, which is
 * what they protect, so they skip only on Linux: `it.skipIf(onLinux)(...)`.
 * The `characterisation-suite` gate allows exactly that form and still
 * counts it as a case.
 */
export const onLinux = process.platform === 'linux';

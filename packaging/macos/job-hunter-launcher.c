#include <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) {
    fprintf(stderr, "Job Hunter launcher: executable path is too long\n");
    return 1;
  }

  char resolved[PATH_MAX];
  if (realpath(executable, resolved) == NULL) {
    perror("Job Hunter launcher: realpath");
    return 1;
  }

  char executable_copy[PATH_MAX];
  char macos_dir[PATH_MAX];
  snprintf(executable_copy, sizeof(executable_copy), "%s", resolved);
  snprintf(macos_dir, sizeof(macos_dir), "%s", dirname(executable_copy));
  const char *contents_dir = dirname(macos_dir);

  char node[PATH_MAX];
  char launcher[PATH_MAX];
  snprintf(node, sizeof(node), "%s/Resources/runtime/bin/node", contents_dir);
  snprintf(launcher, sizeof(launcher), "%s/Resources/launcher/job-hunter-launcher.js", contents_dir);

  execl(node, node, launcher, (char *)NULL);
  perror("Job Hunter launcher: unable to start bundled runtime");
  return 1;
}

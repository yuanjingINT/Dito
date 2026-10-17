#include "dito.h"
#include <errno.h>
#include <fcntl.h>
#include <openssl/evp.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Local clipboard helpers read an anonymous 0600 file. Never use shell
 * interpolation, network requests, or a persistent export of conversation. */
static int helper(FILE *input, char *const argv[]) {
  if (fseek(input, 0, SEEK_SET))
    return -1;
  pid_t pid = fork();
  if (pid < 0)
    return -1;
  if (!pid) {
    setpgid(0, 0);
    dup2(fileno(input), STDIN_FILENO);
    int null = open("/dev/null", O_WRONLY);
    if (null >= 0) {
      dup2(null, STDOUT_FILENO);
      dup2(null, STDERR_FILENO);
      if (null > 2)
        close(null);
    }
    fclose(input);
    execvp(argv[0], argv);
    _exit(127);
  }
  setpgid(pid, pid);
  uint64_t deadline = mono_ms() + 750;
  int status = 0;
  while (mono_ms() < deadline) {
    pid_t ended = waitpid(pid, &status, WNOHANG);
    if (ended == pid)
      return WIFEXITED(status) && !WEXITSTATUS(status) ? 0 : -1;
    if (ended < 0 && errno != EINTR)
      return -1;
    struct timespec pause = {0, 10000000};
    nanosleep(&pause, NULL);
  }
  kill(-pid, SIGKILL);
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }
  return -1;
}
int clipboard_write(const char *text) {
  size_t length = strlen(text);
  if (!length || length > 1024 * 1024)
    return -1;
  FILE *input = tmpfile();
  if (input) {
    if (fwrite(text, 1, length, input) == length && !fflush(input)) {
      char *wayland[] = {"wl-copy", "--type", "text/plain;charset=utf-8", NULL};
      char *xclip[] = {"xclip", "-selection", "clipboard", NULL};
      char *xsel[] = {"xsel", "--clipboard", "--input", NULL};
      if (!helper(input, wayland) || !helper(input, xclip) ||
          !helper(input, xsel)) {
        fclose(input);
        return 0;
      }
    }
    fclose(input);
  }
  if (!isatty(STDOUT_FILENO))
    return -1;
  unsigned char *encoded = xmalloc(4 * ((length + 2) / 3) + 1);
  EVP_EncodeBlock(encoded, (const unsigned char *)text, (int)length);
  printf("\x1b]52;c;%s\x07", encoded);
  fflush(stdout);
  free(encoded);
  return 1; /* Terminal clipboard requests have no acknowledgement. */
}

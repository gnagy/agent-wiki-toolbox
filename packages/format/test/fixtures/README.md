# These fixtures are IntelliJ's output, not ours

`intellij.input.md` is a probe document. `intellij.expected.md` is that document **after IntelliJ's
own markdown formatter ran on it**, copied out of the IDE. `narrow.expected.md` is the same, for the
case remark and IntelliJ disagree about most: a one-character aligned column, which remark widens to
three dashes and IntelliJ leaves alone.

**Nobody regenerates these by hand, and nobody edits them to make a test pass.** A failure here means
the IDE changed its formatting, and the fix is to re-capture the file from IntelliJ and say so in the
worklog — not to write what the test wants to see. The whole of the `format` layer exists to promise
byte-identical output to the IDE; a fixture written to match our code deletes that promise and leaves
the tests green.

To re-capture: open the input in IntelliJ, **Code → Reformat Code**, save, copy the result over the
`.expected.md` file, and record which IntelliJ version produced it.

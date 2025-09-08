// Run.js (auto-wrap snippets before compile)
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

function  DeleteAfterExecution(...filePaths) {
    filePaths.forEach(filePath => {
        fs.unlink(filePath, (err) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    console.log(`File ${filePath} does not exist`);
                } else {
                    console.log(`Error occurred while deleting the ${filePath} file, err : ${err}`);
                }
            } else {
                console.log(`Successfully deleted the ${filePath} file`);
            }
        });
    });
}

async function writeCppToFile(code, scriptPath) {
    return new Promise((resolve, reject) => {
        fs.writeFile(scriptPath, code, (err) => {
            if (err) {
                console.log(`Error occurred while writing the ${scriptPath} file, err : ${err}`);
                reject(err);
            } else {
                console.log(`Successfully written the ${scriptPath} file`);
                resolve();
            }
        });
    });
}

/**
 * Heuristic wrapper for student snippets:
 * - If code contains main(...) => return code unchanged
 * - Else extract #include and using namespace lines to keep them at top
 * - If <iostream> is missing and code references cout/cin/endl, add it
 * - Wrap remaining code in int main() { ... return 0; }
 */
function prepareCppSource(snippet) {
    // Quick detection for an existing main function
    if (/\bmain\s*\(/.test(snippet)) {
        return snippet;
    }

//     // Extract include and using lines
//     let includeLines = (snippet.match(/^\s*#\s*include.*$/mg) || []).map(s => s.trim());
//     let usingLines = (snippet.match(/^\s*using\s+namespace.*$/mg) || []).map(s => s.trim());

//     // Remove extracted lines from the rest
//     let rest = snippet
//         .replace(/^\s*#\s*include.*$/mg, '')
//         .replace(/^\s*using\s+namespace.*$/mg, '')
//         .trim();

//     // If the rest references cout/cin/endl and iostream not included, add it
//     const iostreamIncluded = includeLines.some(l => /<iostream>/.test(l) || /iostream/.test(l));
//     if (!iostreamIncluded && /\b(cout|cin|endl)\b/.test(rest)) {
//         includeLines.unshift('#include <iostream>');
//     }

//     // If rest is empty but user had other top-level statements (e.g. declarations),
//     // keep it inside main anyway.
//     // Build wrapped source
//     const header = (includeLines.length ? includeLines.join('\n') + '\n' : '') +
//                    (usingLines.length ? usingLines.join('\n') + '\n' : '');

//     const body = rest.length ? rest + '\n' : '';

//     const wrapped = `${header}
// int main() {
// ${body}    return 0;
// }
// `;
//     return wrapped;
}

/**
 * RunCpp(code, input, TimeLimitInSeconds)
 * returns Promise that resolves to:
 *  - { success: true, outputFilePath, verdict: "Run Successful" }
 *  - { success: false, message, verdict: "..." }
 */
async function RunCpp(code, input = "", TimeLimit = 5) {
    return new Promise(async (resolve, reject) => {
        const scriptName = Date.now().toString();
        const scriptPath = path.join(__dirname, `${scriptName}.cpp`);
        const exeName = process.platform === 'win32' ? `${scriptName}.exe` : `${scriptName}.out`;
        const executablePath = path.join(__dirname, exeName);
        const outputFilePath = path.join(__dirname, `${scriptName}.txt`);

        // Maximum output bytes limit (from env or default 5MB)
        const maxFileSize = parseInt(process.env.MemoryLimitForOutputFileInBytes || '', 10) || (5 * 1024 * 1024);

        // Preprocess / wrap snippet into a full program if needed
        const sourceToWrite = prepareCppSource(code);

        try {
            await writeCppToFile(sourceToWrite, scriptPath);
        } catch (err) {
            resolve({
                success: false,
                message: `Error occurred while writing the ${scriptPath} file`,
                verdict: "Compilation Error"
            });
            return;
        }

        // 1) Compile using g++
        execFile('g++', [scriptPath, '-o', executablePath], { timeout: 20000 }, (compileErr, stdoutCompile, stderrCompile) => {
            if (compileErr) {
                console.log(`Compilation failed: ${stderrCompile || compileErr.message}`);
                // Return compilation error with compiler message for debugging
                DeleteAfterExecution(scriptPath, executablePath);
                resolve({
                    success: false,
                    message: `Error occurred while Compiling the code: ${stderrCompile || compileErr.message}`,
                    verdict: "Compilation Error"
                });
                return;
            }

            // 2) Spawn executable and stream stdout to output file while enforcing time & size limits
            const writeStream = fs.createWriteStream(outputFilePath, { flags: 'w' });
            let bytesWritten = 0;
            let killedDueTo = null; // "tle" | "mle" | null
            let stderrBuffer = "";

            // Use spawn with absolute path to executable
            const child = spawn(executablePath, [], { windowsHide: true });

            // Timeout timer
            const killTimer = setTimeout(() => {
                killedDueTo = "tle";
                try { child.kill('SIGKILL'); } catch (e) {}
            }, TimeLimit * 1000);

            // handle stdout streaming and enforce maxFileSize
            child.stdout.on('data', chunk => {
                const chunkBuf = Buffer.from(chunk);
                const remaining = maxFileSize - bytesWritten;
                if (remaining <= 0) {
                    // Already at/over limit — kill
                    killedDueTo = "mle";
                    try { child.kill('SIGKILL'); } catch (e) {}
                    return;
                }
                if (chunkBuf.length > remaining) {
                    // write only part of chunk to reach limit then kill
                    writeStream.write(chunkBuf.slice(0, remaining), () => {
                        bytesWritten += remaining;
                        killedDueTo = "mle";
                        try { child.kill('SIGKILL'); } catch (e) {}
                    });
                } else {
                    writeStream.write(chunkBuf, () => {
                        bytesWritten += chunkBuf.length;
                    });
                }
            });
            child.stderr.on('data', data => {
                stderrBuffer += data.toString();
            });
            // write input (if any) then close stdin
            if(input) {
                try {
                    child.stdin.write(input);
                } catch (e) {}
            }
            try { child.stdin.end(); } catch (e) {}

            child.on('error', (err) => {
                clearTimeout(killTimer);
                writeStream.end();
                console.log("Execution spawn error:", err);
                DeleteAfterExecution(scriptPath, executablePath);
                fs.unlink(outputFilePath, () => {
                    resolve({
                        success: false,
                        message: `Error occured while running the script ${executablePath}: ${err.message}`,
                        verdict: "Runtime Error"
                    });
                });
            });
            child.on('close', (code, signal) => {
                clearTimeout(killTimer);
                writeStream.end(() => {
                    // If we killed due to MLE or TLE
                    if (killedDueTo === "tle") {
                        fs.unlink(outputFilePath, () => {
                            DeleteAfterExecution(scriptPath, executablePath);
                            resolve({
                                success: false,
                                message: `script took too long to execute.`,
                                verdict: "Time Limit Exceeded"
                            });
                        });
                        return;
                    }
                    if (killedDueTo === "mle") {
                        fs.unlink(outputFilePath, () => {
                            DeleteAfterExecution(scriptPath, executablePath);
                            resolve({
                                success: false,
                                message: `Output File size exceeds ${(maxFileSize / (1024 * 1024)).toFixed(2)} MB`,
                                verdict: "Memory Limit Exceeded"
                            });
                        });
                        return;
                    }

                    // If program exited with non-zero code -> runtime error
                    if (code !== 0) {
                        fs.unlink(outputFilePath, () => {
                            DeleteAfterExecution(scriptPath, executablePath);
                            resolve({
                                success: false,
                                message: `Runtime Error: ${stderrBuffer || `exit code ${code}`}`,
                                verdict: "Runtime Error"
                            });
                        });
                        return;
                    }

                    // Successful run
                    DeleteAfterExecution(scriptPath, executablePath);
                    resolve({
                        success: true,
                        outputFilePath: outputFilePath,
                        verdict: "Run Successful"
                    });
                });
            });
        });
    });
}

module.exports = { RunCpp, DeleteAfterExecution };

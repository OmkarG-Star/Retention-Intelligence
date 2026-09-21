@echo off
REM Start the API + dashboard. Assumes scripts\setup.bat has already been run.
setlocal
cd /d "%~dp0.."
set "ROOT=%CD%"

if exist ".venv\Scripts\activate.bat" call .venv\Scripts\activate.bat

set "PYTHONPATH=%ROOT%\src"

if not exist "data\processed\warehouse.db" (
  echo No warehouse found. Running the pipeline first...
  python -m attrition.cli pipeline
  if errorlevel 1 exit /b 1
)

echo Serving on http://127.0.0.1:8000  ^(Ctrl+C to stop^)
python -m attrition.cli serve %*
endlocal

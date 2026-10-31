import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/onest';
import '@fontsource-variable/noto-sans-thai';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/screens.css';
import { App } from './app';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

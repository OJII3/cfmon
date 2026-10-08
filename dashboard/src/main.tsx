import React from 'react';
import { createRoot } from 'react-dom/client';
import { createTheme, MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import App from './ui/App';
import './ui/styles.css';

const theme = createTheme({
  primaryColor: 'teal',
  defaultRadius: 'md',
  fontFamily: 'Inter, "Noto Sans JP", sans-serif',
  headings: { fontFamily: 'Inter, "Noto Sans JP", sans-serif' },
  colors: {
    teal: ['#e5fff6', '#c9f8e8', '#9cebd0', '#70ddb8', '#4dcda4', '#35b78f', '#249b76', '#197a5d', '#125b46', '#0b3d30'],
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><MantineProvider theme={theme} defaultColorScheme="dark"><App /></MantineProvider></React.StrictMode>,
);
